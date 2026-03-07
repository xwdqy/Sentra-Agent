import { createLogger } from './logger.js';
import { tDelayJobQueue } from './i18n/delayJobQueueCatalog.js';
import type { DelayDueTriggerJob } from './delayRuntimeTypes.js';

const logger = createLogger('DelayJobQueue');

// 内存级延迟任务队列：
// 1) 任务仅保存在当前进程内存。
// 2) 进程重启/崩溃后任务会丢失，不做补发。
// 3) 与主任务持久化存储解耦。

type DelayJob = DelayDueTriggerJob & {
  maxLagMs?: number;
};

type DelayWorkerOptions = {
  intervalMs?: number;
  runJob?: (job: DelayJob) => Promise<unknown> | void;
  maxLagMs?: number;
};

const jobs = new Map<string, DelayJob>(); // jobId -> job payload

export async function loadAllDelayedJobs(): Promise<DelayJob[]> {
  return Array.from(jobs.values());
}

export async function enqueueDelayedJob(job: DelayJob): Promise<DelayJob> {
  if (!job || !job.jobId) {
    throw new Error('enqueueDelayedJob requires non-empty jobId');
  }
  const now = Date.now();
  const createdAt = Number.isFinite(Number(job.createdAt)) ? Number(job.createdAt) : now;
  const fireAt = Number.isFinite(Number(job.fireAt)) ? Number(job.fireAt) : now;
  const payload = {
    ...job,
    jobId: String(job.jobId),
    createdAt,
    fireAt
  };

  jobs.set(payload.jobId, payload);
  logger.info(tDelayJobQueue('enqueue'), {
    jobId: payload.jobId,
    aiName: payload.aiName || '',
    fireAt: payload.fireAt
  });

  return payload;
}

async function removeJob(jobId: string | number): Promise<void> {
  if (!jobId) return;
  const jid = String(jobId);
  if (jobs.delete(jid)) {
    logger.debug(tDelayJobQueue('removed'), { jobId: jid });
  }
}

const workerState = {
  started: false
};

export function startDelayJobWorker({ intervalMs = 1000, runJob, maxLagMs }: DelayWorkerOptions = {}) {
  if (workerState.started) return;
  if (typeof runJob !== 'function') {
    logger.warn(tDelayJobQueue('worker_start_skipped_missing_run_job'));
    return;
  }
  workerState.started = true;
  const running = new Set<string>();

  const defaultMaxLagMs = Number.isFinite(Number(maxLagMs)) && Number(maxLagMs) >= 0
    ? Number(maxLagMs)
    : 0;

  const tick = async () => {
    try {
      const snapshot = await loadAllDelayedJobs();
      const now = Date.now();
      for (const job of snapshot) {
        if (!job || !job.jobId) continue;
        const jid = String(job.jobId);
        if (running.has(jid)) continue;

        const fireAt = Number(job.fireAt || 0);
        if (!Number.isFinite(fireAt)) {
          await removeJob(jid);
          continue;
        }

        // 对严重过期任务直接丢弃（例如进程长时间挂起后恢复）。
        const lagMs = now - fireAt;
        const jobMaxLagMs = Number(job.maxLagMs);
        const limit = Number.isFinite(jobMaxLagMs) && jobMaxLagMs >= 0
          ? jobMaxLagMs
          : defaultMaxLagMs;
        if (limit > 0 && lagMs > limit) {
          logger.info(tDelayJobQueue('drop_overdue_job'), {
            jobId: jid,
            aiName: job.aiName || '',
            fireAt,
            now,
            lagMs,
            maxLagMs: limit
          });
          await removeJob(jid);
          continue;
        }

        if (fireAt > now) continue;

        running.add(jid);
        (async () => {
          try {
            logger.info(tDelayJobQueue('trigger'), {
              jobId: jid,
              aiName: job.aiName || '',
              fireAt
            });
            await runJob(job);
          } catch (e) {
            logger.warn(tDelayJobQueue('run_job_failed'), {
              jobId: jid,
              err: String(e)
            });
          } finally {
            await removeJob(jid);
            running.delete(jid);
          }
        })();
      }
    } catch (e) {
      logger.warn(tDelayJobQueue('worker_tick_failed'), { err: String(e) });
    } finally {
      setTimeout(tick, Math.max(200, intervalMs || 1000));
    }
  };

  setTimeout(tick, Math.max(200, intervalMs || 1000));
}
