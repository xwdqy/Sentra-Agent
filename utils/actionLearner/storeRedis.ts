import { getRedis } from '../redisClient.js';
import { createLogger } from '../logger.js';
import { loadActionLearnerConfig } from './config.js';
import type { ActionModelState, ActionStoreSampleRecord, ActionTrainingSample } from './types.js';

const logger = createLogger('ActionLearnerStore');

export type RedisActionLearnerStoreOptions = {
  namespace?: string;
  sampleStreamMaxLen?: number;
};

function encodeSample(sample: ActionTrainingSample): string {
  return JSON.stringify(sample);
}

function decodeSample(raw: unknown): ActionTrainingSample | null {
  try {
    const text = String(raw || '').trim();
    if (!text) return null;
    const obj = JSON.parse(text) as ActionTrainingSample;
    if (!obj || typeof obj !== 'object') return null;
    if (!obj.sampleId || !obj.teacher || !obj.text) return null;
    return obj;
  } catch {
    return null;
  }
}

function decodeModel(raw: unknown): ActionModelState | null {
  try {
    const text = String(raw || '').trim();
    if (!text) return null;
    const obj = JSON.parse(text) as ActionModelState;
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch {
    return null;
  }
}

function flattenFields(row: unknown): string[] {
  if (!Array.isArray(row)) return [];
  const out: string[] = [];
  for (const item of row) {
    out.push(String(item ?? ''));
  }
  return out;
}

function fieldsToMap(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (!key) continue;
    out[key] = value ?? '';
  }
  return out;
}

export class RedisActionLearnerStore {
  private readonly namespace: string;
  private readonly sampleStreamMaxLen: number;

  constructor(options: RedisActionLearnerStoreOptions = {}) {
    const cfg = loadActionLearnerConfig();
    this.namespace = String(options.namespace || cfg.namespace).trim() || cfg.namespace;
    this.sampleStreamMaxLen = Number.isFinite(options.sampleStreamMaxLen)
      ? Math.max(1000, Math.floor(options.sampleStreamMaxLen as number))
      : cfg.sampleStreamMaxLen;
  }

  private keyActiveModel(): string {
    return `${this.namespace}_model_active`;
  }

  private keyModel(version: string): string {
    return `${this.namespace}_model_v_${version}`;
  }

  private keySamples(): string {
    return `${this.namespace}_samples`;
  }

  private keyCursor(): string {
    return `${this.namespace}_train_cursor`;
  }

  async loadActiveModel(): Promise<ActionModelState | null> {
    const redis = getRedis();
    if (!redis) return null;
    const version = await redis.get(this.keyActiveModel());
    if (!version) return null;
    const payload = await redis.get(this.keyModel(version));
    return decodeModel(payload);
  }

  async saveModel(state: ActionModelState, version: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    const v = String(version || '').trim();
    if (!v) return;
    const payload = JSON.stringify(state);
    const key = this.keyModel(v);
    const tx = redis.multi();
    tx.set(key, payload);
    tx.set(this.keyActiveModel(), v);
    await tx.exec();
  }

  async appendSample(sample: ActionTrainingSample): Promise<string | null> {
    const redis = getRedis();
    if (!redis) return null;
    const payload = encodeSample(sample);
    try {
      const id = await redis.xadd(
        this.keySamples(),
        'MAXLEN',
        '~',
        String(this.sampleStreamMaxLen),
        '*',
        'payload',
        payload,
        'ts',
        String(sample.ts || Date.now())
      );
      return typeof id === 'string' ? id : null;
    } catch (error) {
      logger.warn('写入 action learner 样本失败', { err: String(error) });
      return null;
    }
  }

  async readSamples(afterId: string, count: number): Promise<ActionStoreSampleRecord[]> {
    const redis = getRedis();
    if (!redis) return [];
    const cursor = String(afterId || '0-0').trim() || '0-0';
    const batch = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 100;
    try {
      const rows = await redis.xrange(this.keySamples(), `(${cursor}`, '+', 'COUNT', String(batch));
      if (!Array.isArray(rows)) return [];
      const out: ActionStoreSampleRecord[] = [];
      for (const row of rows) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const id = String(row[0] || '');
        const fields = flattenFields(row[1]);
        const map = fieldsToMap(fields);
        const sample = decodeSample(map.payload);
        if (!id || !sample) continue;
        out.push({ id, sample });
      }
      return out;
    } catch (error) {
      logger.warn('读取 action learner 样本失败', { err: String(error) });
      return [];
    }
  }

  async loadCursor(): Promise<string> {
    const redis = getRedis();
    if (!redis) return '0-0';
    const raw = await redis.get(this.keyCursor());
    const cursor = String(raw || '').trim();
    return cursor || '0-0';
  }

  async saveCursor(cursor: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    const value = String(cursor || '').trim();
    if (!value) return;
    await redis.set(this.keyCursor(), value);
  }
}
