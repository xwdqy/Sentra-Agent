import { createLogger } from '../logger.js';
import { loadActionLearnerConfig } from './config.js';
import { ActionLearnerRuntime } from './runtime.js';
import { RedisActionLearnerStore } from './storeRedis.js';
import type { ActionLearnerMetrics } from './types.js';

const logger = createLogger('ActionLearnerTrainer');

export type ActionLearnerTrainerOptions = {
  intervalMs: number;
  batchSize: number;
  minTeacherConfidence: number;
  autoSaveModel: boolean;
};

export class ActionLearnerTrainer {
  private readonly runtime: ActionLearnerRuntime;
  private readonly store: RedisActionLearnerStore;
  private readonly options: ActionLearnerTrainerOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    runtime: ActionLearnerRuntime,
    store: RedisActionLearnerStore,
    options: Partial<ActionLearnerTrainerOptions> = {}
  ) {
    const cfg = loadActionLearnerConfig();
    this.runtime = runtime;
    this.store = store;
    this.options = {
      intervalMs: Number.isFinite(options.intervalMs) ? Math.max(500, Number(options.intervalMs)) : cfg.trainerIntervalMs,
      batchSize: Number.isFinite(options.batchSize) ? Math.max(1, Math.floor(Number(options.batchSize))) : cfg.trainerBatchSize,
      minTeacherConfidence: Number.isFinite(options.minTeacherConfidence)
        ? Math.max(0, Math.min(1, Number(options.minTeacherConfidence)))
        : cfg.minTeacherConfidence,
      autoSaveModel: options.autoSaveModel !== false
    };
  }

  async bootstrapModelFromStore(): Promise<void> {
    const state = await this.store.loadActiveModel();
    if (!state) return;
    this.runtime.importModel(state);
  }

  async tick(): Promise<ActionLearnerMetrics> {
    const started = Date.now();
    let trained = 0;
    let skipped = 0;
    let cursor = await this.store.loadCursor();

    const rows = await this.store.readSamples(cursor, this.options.batchSize);
    if (!rows.length) {
      return { trained, skipped, lastCursor: cursor, elapsedMs: Date.now() - started };
    }

    for (const row of rows) {
      cursor = row.id;
      const conf = row.sample?.teacher?.confidence;
      if (typeof conf === 'number' && Number.isFinite(conf) && conf < this.options.minTeacherConfidence) {
        skipped += 1;
        continue;
      }
      this.runtime.learnFromSample(row.sample, 1);
      trained += 1;
    }

    await this.store.saveCursor(cursor);

    if (this.options.autoSaveModel && trained > 0) {
      const version = String(Date.now());
      await this.store.saveModel(this.runtime.exportModel(), version);
    }

    return { trained, skipped, lastCursor: cursor, elapsedMs: Date.now() - started };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.tick()
        .then((metrics) => {
          if (metrics.trained > 0 || metrics.skipped > 0) {
            logger.info('action learner incremental train done', metrics);
          }
        })
        .catch((error) => {
          logger.warn('action learner incremental train failed', { err: String(error) });
        })
        .finally(() => {
          this.running = false;
        });
    }, this.options.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

