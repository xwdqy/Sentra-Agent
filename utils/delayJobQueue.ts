import { createLogger } from './logger.js';

const logger = createLogger('DelayJobQueue');

// 内存级延迟任务队列：
// - 所有任务只保存在当前进程内存中；
// - 进程重启 / 崩溃后自动丢弃，不再尝试补发；
// - 与主任务队列、持久化存储彻底解耦。

type DelayJob = {
  jobId?: string | number;
  aiName?: string;
  createdAt?: number;
  fireAt?: number;
  maxLagMs?: number;
  [key: string]: unknown;
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
    throw new Error('enqueueDelayedJob 需要包含 jobId 的 job 对象');
  }
  const now = Date.now();
  const createdAt = Number.isFinite(Number(job.createdAt)) ? Number(job.createdAt) : now;
  const fireAt = Number.isFinite(Number(job.fireAt)) ? Number(job.fireAt) : now;
  const payload = {
    ...job,
    jobId: String(job.jobId),
    createdAt,
    fireAt,
  };

  jobs.set(payload.jobId, payload);
  logger.info('DelayJobQueue: 入队延迟任务', {
    jobId: payload.jobId,
    aiName: payload.aiName || '',
    fireAt: payload.fireAt,
  });

  return payload;
}

async function removeJob(jobId: string | number): Promise<void> {
  if (!jobId) return;
  const jid = String(jobId);
  if (jobs.delete(jid)) {
    logger.debug('DelayJobQueue: 删除延迟任务', { jobId: jid });
  }
}

const workerState = {
  started: false,
};

export function startDelayJobWorker({ intervalMs = 1000, runJob, maxLagMs }: DelayWorkerOptions = {}) {
  if (workerState.started) return;
  if (typeof runJob !== 'function') {
    logger.warn('DelayJobQueue: 未提供 runJob 回调，跳过启动 worker');
    return;
  }
  workerState.started = true;
  const running = new Set();

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

        // 丢弃严重过期的任务（例如进程长时间挂起后恢复），而不是补发
        const lagMs = now - fireAt;
        const jobMaxLagMs = Number(job.maxLagMs);
        const limit = Number.isFinite(jobMaxLagMs) && jobMaxLagMs >= 0
          ? jobMaxLagMs
          : defaultMaxLagMs;
        if (limit > 0 && lagMs > limit) {
          logger.info('DelayJobQueue: 丢弃过期延迟任务', {
            jobId: jid,
            aiName: job.aiName || '',
            fireAt,
            now,
            lagMs,
            maxLagMs: limit,
          });
          await removeJob(jid);
          continue;
        }

        if (fireAt > now) continue;

        running.add(jid);
        (async () => {
          try {
            logger.info('DelayJobQueue: 触发延迟任务', {
              jobId: jid,
              aiName: job.aiName || '',
              fireAt,
            });
            await runJob(job);
          } catch (e) {
            logger.warn('DelayJobQueue: 运行延迟任务失败', {
              jobId: jid,
              err: String(e),
            });
          } finally {
            await removeJob(jid);
            running.delete(jid);
          }
        })();
      }
    } catch (e) {
      logger.warn('DelayJobQueue: worker tick 异常', { err: String(e) });
    } finally {
      setTimeout(tick, Math.max(200, intervalMs || 1000));
    }
  };

  setTimeout(tick, Math.max(200, intervalMs || 1000));
}
